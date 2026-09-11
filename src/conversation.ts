// What the human and Collie have said to each other about this Herd's work, kept on
// disk so closing the board loses nothing.
//
// Two things are done to a turn before it is written. Credential-shaped values are
// replaced by what kind of credential they looked like, because a conversation about a
// failing deploy is exactly where one gets pasted. And every reference is checked to
// point inside a Run's own directory, because a reference is something the board will
// later render and offer to open.
//
// Worker terminal transcripts are never stored here. What an agent is doing reaches the
// conversation as herdr's own status and title, and no further.

import { Data, DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { readJournal } from "./journal";
import { ensureLockDir, withLock } from "./lock";
import { herdDir } from "./steering";
import { nowIso } from "./time";

/** How much of a conversation is kept. Old enough or far enough back, and it goes. */
export const MAX_TURNS = 500;
export const MAX_AGE_DAYS = 30;

const TurnSchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  role: Schema.Literals(["human", "collie"]),
  text: Schema.String,
  /** The Run this turn was about, where it named one. */
  target: Schema.optionalKey(Schema.String),
  card: Schema.optionalKey(Schema.String),
  proposal: Schema.optionalKey(Schema.String),
  evaluator_call: Schema.optionalKey(Schema.String),
});
export type Turn = Schema.Schema.Type<typeof TurnSchema>;
/** A turn while it is being built: the optional keys are set only where there is one. */
type Draft = { -readonly [K in keyof Turn]: Turn[K] };
const TurnJson = Schema.fromJsonString(TurnSchema);
const encodeTurn = Schema.encodeSync(TurnJson);

/**
 * Shapes that are almost certainly a secret, and what to say instead. The type is kept
 * because it is the useful half — "a GitLab token was in here" is worth reading, and the
 * token itself is worth nothing to anyone who should be reading this.
 *
 * Deliberately over-eager. A conversation is a place people paste things, and a false
 * positive costs a human retyping a word; a false negative writes a live credential into
 * a file that outlives the session.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "<gitlab token>"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<github token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<github token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<api key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<aws key id>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<slack token>"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>"],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, "Bearer <token>"],
  // A named assignment whose value looks like a secret rather than like prose.
  [
    /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY))\s*[=:]\s*\S+/g,
    "$1=<redacted>",
  ],
];

/** The text as it will be written: same words, minus anything that looked like a key. */
export function redact(text: string): string {
  let out = text;
  for (const [looksLike, replacement] of SECRETS) out = out.replace(looksLike, replacement);
  return out;
}

/**
 * A reference the board may later render and offer to open, or `<external>`. Anything
 * outside the Run's own directories is refused rather than shown: a path in a turn came
 * from a model, and a model's idea of an interesting file is not a reason to open one.
 */
export function insideKnown(path: string, roots: ReadonlyArray<string>): boolean {
  return roots.some((root) => root !== "" && (path === root || path.startsWith(`${root}/`)));
}

export const conversationPath = Effect.fn("Conversation.path")(function* (
  stateDir: string,
  herdKey: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, herdKey), "conversation.jsonl");
});

export class ConversationBusy extends Data.TaggedError("ConversationBusy")<{ file: string }> {}

export const read = (file: string) => readJournal(file, TurnJson);

/**
 * What is kept: the newest `MAX_TURNS`, and nothing older than `MAX_AGE_DAYS`. Trimmed on
 * write rather than by a sweep, because there is no daemon to sweep with — and because
 * the write is the only moment anyone holds the lock.
 */
export function keep(turns: ReadonlyArray<Turn>, nowMs: number): Turn[] {
  const oldest = nowMs - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return turns
    .filter((turn) => {
      const at = Date.parse(turn.at);
      return Number.isNaN(at) || at >= oldest;
    })
    .slice(-MAX_TURNS);
}

export interface NewTurn {
  readonly role: "human" | "collie";
  readonly text: string;
  readonly target?: string;
  readonly card?: string;
  readonly proposal?: string;
  readonly evaluatorCall?: string;
}

export const append = Effect.fn("Conversation.append")(function* (
  file: string,
  turn: NewTurn,
  /** Where a reference is allowed to point: the Run directories this Herd has. */
  roots: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const at = yield* nowIso();
  const written: Draft = {
    id: `t-${Bun.hash(`${at}${turn.role}${turn.text}`).toString(16)}`,
    at,
    role: turn.role,
    text: sanitise(redact(turn.text), roots),
  };
  if (turn.target !== undefined) written.target = turn.target;
  if (turn.card !== undefined) written.card = turn.card;
  if (turn.proposal !== undefined) written.proposal = turn.proposal;
  if (turn.evaluatorCall !== undefined) written.evaluator_call = turn.evaluatorCall;
  yield* ensureLockDir(file);
  yield* withLock(
    `${file}.lock`,
    Effect.fail(new ConversationBusy({ file })),
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const kept = keep([...(yield* read(file)), written], nowMs);
      const tmp = `${file}.${process.pid}.tmp`;
      yield* fs.writeFileString(tmp, kept.map((line) => `${encodeTurn(line)}\n`).join(""));
      yield* fs.rename(tmp, file);
    }),
  );
  return written;
});

/** Absolute paths in a turn's text that point nowhere Collie knows, blanked. */
function sanitise(text: string, roots: ReadonlyArray<string>): string {
  if (roots.length === 0) return text;
  return text.replace(/(^|\s)(\/[^\s'"`)]+)/g, (whole, lead: string, found: string) =>
    insideKnown(found, roots) ? whole : `${lead}<external>`,
  );
}

/** The last `n` turns, newest last, optionally only those about one Run. */
export const tail = Effect.fn("Conversation.tail")(function* (
  file: string,
  n: number,
  about?: string,
) {
  const turns = yield* read(file);
  const mine = about === undefined ? turns : turns.filter((turn) => turn.target === about);
  return mine.slice(-n);
});

/**
 * Proposals this conversation raised that nobody has answered. The journal names them;
 * whether each is still pending is the proposals journal's answer, so the caller passes
 * that in rather than this module reading a second file.
 */
export const pendingProposals = Effect.fn("Conversation.pendingProposals")(function* (
  file: string,
  stillPending: (id: string) => boolean,
) {
  const ids = new Set<string>();
  for (const turn of yield* read(file))
    if (turn.proposal !== undefined && stillPending(turn.proposal)) ids.add(turn.proposal);
  return [...ids];
});
