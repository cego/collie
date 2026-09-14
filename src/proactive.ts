// When Collie speaks without being spoken to.
//
// A conversation you have to start every time is not oversight, it is polling by hand: a
// human ends up asking "anything happened?" every few minutes, which is the job they
// wanted Collie for. So a meaningful change in what the board has *already read* produces
// one turn, addressed to the human.
//
// Two things this is deliberately not. It is not a process: there is no idle agent and no
// timer that calls a model to find out whether anything happened — the Home already
// recomputes board state to draw it, and a transition in that is the whole trigger. And
// it is not a licence: what Collie may then *do* is decided by the same `validate` path a
// typed message goes through, so who started the turn is not an input to what is
// permitted.
//
// Activity is not a trigger. A step starting, a pane changing, a commit, time passing —
// none of them are on the list, for the same reason a changing pane is not progress.

import { Effect, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";
import type { RunRecord } from "./run";

const SaidSchema = Schema.Struct({ at: Schema.String, key: Schema.String });
const SaidJson = Schema.fromJsonString(SaidSchema);

/** One thing worth saying, and the key that stops it being said twice. */
export interface Event {
  /** The Run it is about, which is also what a proposal about it would target. */
  run: string;
  /**
   * What makes this event this event. The reason rather than the moment, so a board that
   * redraws every three seconds does not report the same halt two hundred times — and a
   * Run that halts, is resumed and halts again for a *different* reason says so.
   */
  key: string;
  /** What Collie is being asked about, in the words the human will see it answered in. */
  text: string;
}

/**
 * What is worth starting a turn about, from records the board has already read.
 *
 * Every one of these is a Run arriving somewhere a human would want to know about, and
 * none of them is a Run getting on with it. The wording is a question rather than a
 * report, because what comes back is Collie's answer and it should read as one.
 */
export function eventsIn(
  records: ReadonlyArray<RunRecord>,
  /**
   * Runs whose drift Collie escalated rather than corrected, by the constraint drifted
   * from. Read from the drift journal by the caller: a record does not carry it, and the
   * board already reads that journal to mark the row.
   */
  drifting: ReadonlyMap<string, string> = new Map(),
): Event[] {
  const out: Event[] = [];
  for (const record of records) {
    const about = record.target_label ?? record.slug;
    // Stopped for a reason it recorded: the reason is the key, so a resume that halts
    // again the same way is the same event and a different halt is a new one.
    if (record.halt !== null) {
      out.push({
        run: record.id,
        key: `${record.id}:halt:${record.halt}:${record.iteration}`,
        text: `Run ${record.id} (${about}) stopped with ${record.halt}. What is going on, and what should happen next?`,
      });
      continue;
    }
    // Waiting on a person. A question nobody sees is a Run that has stopped for the day.
    if (record.awaiting !== null && record.status !== "done") {
      out.push({
        run: record.id,
        key: `${record.id}:awaiting:${record.awaiting}`,
        text: `Run ${record.id} (${about}) is waiting on me (${record.awaiting}). What is it asking, and what turns on the answer?`,
      });
      continue;
    }
    // Claimed to be finished without proving it. The gap list is the key: proving one of
    // three is progress, and worth saying so.
    if (record.evidence_gaps.length > 0) {
      out.push({
        run: record.id,
        key: `${record.id}:gaps:${record.evidence_gaps.join("|")}`,
        text: `Run ${record.id} (${about}) cannot show it did what it set out to: ${record.evidence_gaps.join("; ")}. What is missing, and is it worth doing?`,
      });
      continue;
    }
    // Drifted from its Intent past what Collie was allowed to correct. Already classified
    // as the human's: the constraint is the key, so a second escalation on another one is
    // a second thing to say.
    const drifted = drifting.get(record.id);
    if (drifted !== undefined && record.status !== "done" && record.status !== "failed") {
      out.push({
        run: record.id,
        key: `${record.id}:drift:${drifted}`,
        text: `Run ${record.id} (${about}) drifted from ${drifted} and Collie could not correct it. What is it doing instead, and should it be stopped or steered?`,
      });
      continue;
    }
    // Going round. The obstacle's own words are the key, so the same obstacle is said
    // once and a new one is said again.
    if (record.obstacle !== null) {
      out.push({
        run: record.id,
        key: `${record.id}:obstacle:${record.obstacle}`,
        text: `Run ${record.id} (${about}) is repeating itself: ${record.obstacle} Is there a way round it?`,
      });
      continue;
    }
    // Ended. Both endings are news: one because the work is there to look at, and one
    // because it is not.
    if (record.status === "done" || record.status === "failed") {
      out.push({
        run: record.id,
        key: `${record.id}:ended:${record.status}`,
        text: `Run ${record.id} (${about}) ended ${record.status}. What came of it, and is there anything left to do?`,
      });
      continue;
    }
    // Stopped for a human without a halt code or a question: a step blocked with a note.
    // The iteration is the key, so a resume that blocks again is said again.
    if (record.status === "blocked") {
      const why = record.summary?.split("\n")[0] ?? "a step stopped for a human";
      out.push({
        run: record.id,
        key: `${record.id}:blocked:${record.iteration}`,
        text: `Run ${record.id} (${about}) is blocked: ${why}. What does it need, and from whom?`,
      });
    }
  }
  return out;
}

export const saidPath = Effect.fn("Proactive.saidPath")(function* (herdDir: string) {
  const path = yield* Path.Path;
  return path.join(herdDir, "proactive.jsonl");
});

export const readSaid = Effect.fn("Proactive.readSaid")(function* (herdDir: string) {
  const lines = yield* readJournal(yield* saidPath(herdDir), SaidJson).pipe(
    Effect.catch(() => Effect.succeed([])),
  );
  return new Set(lines.map((line) => line.key));
});

export const remember = Effect.fn("Proactive.remember")(function* (
  herdDir: string,
  key: string,
  at: string,
) {
  yield* appendJournal(yield* saidPath(herdDir), SaidJson, { at, key }).pipe(Effect.orDie);
});

/**
 * The next thing to say, or nothing. One at a time on purpose: several Runs ending
 * together is one thing that happened, and a board that fired five turns at once would
 * be the notification storm this is meant to replace.
 */
export function nextEvent(events: ReadonlyArray<Event>, said: ReadonlySet<string>): Event | null {
  return events.find((event) => !said.has(event.key)) ?? null;
}
