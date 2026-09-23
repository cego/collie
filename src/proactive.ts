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
import { runTitle } from "./naming";
import { settled, type RunFacts } from "./runs";

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
  runs: ReadonlyArray<RunFacts>,
  /**
   * Runs whose drift Collie escalated rather than corrected, by the constraint drifted
   * from. Read from the drift journal by the caller, which already reads it to mark rows.
   */
  drifting: ReadonlyMap<string, string> = new Map(),
): Event[] {
  const out: Event[] = [];
  for (const run of runs) {
    // History is what happened: nothing an older Collie recorded is news now.
    if (run.imported) continue;
    const about = runTitle(run);
    const asked = run.asking[0];
    if (asked !== undefined) {
      out.push({
        run: run.id,
        key: `${run.id}:asking:${asked.name}`,
        text: `Run ${run.id} (${about}) is waiting on me (${asked.name}). What is it asking, and what turns on the answer?`,
      });
      continue;
    }
    const drifted = drifting.get(run.id);
    if (drifted !== undefined && !settled(run)) {
      out.push({
        run: run.id,
        key: `${run.id}:drift:${drifted}`,
        text: `Run ${run.id} (${about}) drifted from ${drifted} and Collie could not correct it. What is it doing instead, and should it be stopped or steered?`,
      });
      continue;
    }
    if (run.state === "waiting") {
      out.push({
        run: run.id,
        key: `${run.id}:parked:${run.note ?? ""}`,
        text: `Run ${run.id} (${about}) parked its work${run.note === null ? "" : `: ${run.note}`}. What does it need, and from whom?`,
      });
      continue;
    }
    if (settled(run)) {
      out.push({
        run: run.id,
        key: `${run.id}:ended:${run.state}`,
        text: `Run ${run.id} (${about}) ended ${run.state}. What came of it, and is there anything left to do?`,
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
