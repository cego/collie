import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Data, DateTime, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { readJournal } from "./journal";
import { redact } from "./redact";
import { ensureLockDir, withLock } from "./lock";
import { herdDir } from "./steering";
import { nowIso, epochMs } from "./time";

export const MAX_TURNS = 500;
export const MAX_AGE_DAYS = 30;

const TurnSchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  // WARNING: kept distinct from human so the conversation never shows the human asking what they did not ask.
  role: Schema.Literals(["human", "collie", "event"]),
  text: Schema.String,
  target: Schema.optionalKey(Schema.String),
  card: Schema.optionalKey(Schema.String),
  proposal: Schema.optionalKey(Schema.String),
  evaluator_call: Schema.optionalKey(Schema.String),
});
export type Turn = Schema.Schema.Type<typeof TurnSchema>;
type Draft = { -readonly [K in keyof Turn]: Turn[K] };
const TurnJson = Schema.fromJsonString(TurnSchema);
const encodeTurn = flow(Schema.encodeResult(TurnJson), Result.getOrThrow);

// WARNING: refused rather than shown: a path in a turn came from a model, which is no reason to open a file.
export function insideKnown(path: string, roots: ReadonlyArray<string>) {
  return Arr.some(
    roots,
    (root) => root !== "" && (path === root || pipe(path, Str.startsWith(`${root}/`))),
  );
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

// WARNING: trimmed on write, not by a sweep: the write is the only moment anyone holds the lock.
export function keep(turns: ReadonlyArray<Turn>, nowMs: number) {
  const oldest = nowMs - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return Arr.filter(turns, (turn) => {
    const at = epochMs(turn.at);
    return Number.isNaN(at) || at >= oldest;
  }).slice(-MAX_TURNS);
}

export interface NewTurn {
  readonly role: Turn["role"];
  readonly text: string;
  readonly target?: string;
  readonly card?: string;
  readonly proposal?: string;
  readonly evaluatorCall?: string;
}

export const append = Effect.fn("Conversation.append")(function* (
  file: string,
  turn: NewTurn,
  roots: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const at = yield* nowIso;
  const written: Draft = {
    id: `t-${Bun.hash(`${at}${turn.role}${turn.text}`).toString(16)}`,
    at,
    role: turn.role,
    text: sanitise(redact(turn.text), roots),
  };
  if (turn.target !== undefined) {
    written.target = turn.target;
  }
  if (turn.card !== undefined) {
    written.card = turn.card;
  }
  if (turn.proposal !== undefined) {
    written.proposal = turn.proposal;
  }
  if (turn.evaluatorCall !== undefined) {
    written.evaluator_call = turn.evaluatorCall;
  }
  yield* ensureLockDir(file);
  yield* withLock(
    `${file}.lock`,
    Effect.fail(new ConversationBusy({ file })),
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const kept = keep([...(yield* read(file)), written], nowMs);
      const tmp = `${file}.${process.pid}.tmp`;
      yield* fs.writeFileString(
        tmp,
        Arr.join(
          Arr.map(kept, (line) => `${encodeTurn(line)}\n`),
          "",
        ),
      );
      yield* fs.rename(tmp, file);
    }),
  );
  return written;
});

function sanitise(text: string, roots: ReadonlyArray<string>) {
  if (roots.length === 0) {
    return text;
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
  return text.replaceAll(/(^|\s)(\/[^\s'"`)]+)/g, (whole, lead: string, found: string) =>
    insideKnown(found, roots) ? whole : `${lead}<external>`,
  );
}

export const tail = Effect.fn("Conversation.tail")(function* (
  file: string,
  n: number,
  about?: string,
) {
  const turns = yield* read(file);
  const mine = about === undefined ? turns : Arr.filter(turns, (turn) => turn.target === about);
  return mine.slice(-n);
});

export const pendingProposals = Effect.fn("Conversation.pendingProposals")(function* (
  file: string,
  stillPending: (id: string) => boolean,
) {
  const ids = new Set<string>();
  for (const turn of yield* read(file)) {
    if (turn.proposal !== undefined && stillPending(turn.proposal)) {
      ids.add(turn.proposal);
    }
  }
  return [...ids];
});
