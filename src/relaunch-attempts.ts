import * as Arr from "effect/Array";
import { Effect, Option, Schema } from "effect";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";

// WARNING: Enough that a harness which merely lost its first pane comes back, and few enough that one which exits at once is not a loop.
export const RELAUNCH_CAP = 3;

const Attempt = Schema.fromJsonString(
  Schema.Struct({
    agent: Schema.String,
    at: Schema.Finite,
    why: Schema.NullOr(Schema.String),
  }),
);

export type RelaunchAttempt = typeof Attempt.Type;

export const rememberRelaunch = (dir: string, attempt: RelaunchAttempt) =>
  appendRunJournal(runJournal(dir, "relaunch.jsonl"), Attempt, attempt);

export const relaunchFailures = (dir: string, agent: string) =>
  readRunJournal(runJournal(dir, "relaunch.jsonl"), Attempt).pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((lines) => {
      const mine = Arr.filter(lines, (one) => one.agent === agent);
      const came = Option.getOrElse(
        Arr.findLastIndex(mine, (one) => one.why === null),
        () => -1,
      );
      const since = came < 0 ? mine : mine.slice(came + 1);
      return { tried: since.length, last: since.at(-1)?.why ?? null };
    }),
  );
