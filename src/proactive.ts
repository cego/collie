// WARNING: activity is not a trigger: only a transition the board already read starts a turn.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";
import { runTitle } from "./naming";
import { settled, type RunFacts } from "./runs";
import { mrLabel, type Reopened, type Significance, type TaskView } from "./board-model";
import { readReplies } from "./replies";

const SaidSchema = Schema.Struct({ at: Schema.String, key: Schema.String });
const SaidJson = Schema.fromJsonString(SaidSchema);

export interface Event {
  run: string;
  key: string;
  text: string;
  significance: Significance;
}

export function eventsIn(
  runs: ReadonlyArray<RunFacts>,
  drifting: ReadonlyMap<string, string> = new Map(),
  ready: ReadonlyMap<string, { at: string; sentence: string }> = new Map(),
  done: ReadonlyMap<string, Reopened> = new Map(),
) {
  return Arr.flatMap(runs, (run) => [
    ...reopenedOf(run, done),
    ...causesOf(run, drifting, ready).slice(0, 1),
  ]);
}

// WARNING: includes events a more pressing one masks, so a masked event is not reported as gone.
export function holding(
  runs: ReadonlyArray<RunFacts>,
  drifting: ReadonlyMap<string, string> = new Map(),
  disposed: ReadonlySet<string> = new Set(),
  ready: ReadonlyMap<string, { at: string; sentence: string }> = new Map(),
  done: ReadonlyMap<string, Reopened> = new Map(),
) {
  return new Set(
    Arr.flatMap(runs, (run) =>
      Arr.map(
        [
          ...reopenedOf(run, done),
          ...Arr.filter(
            causesOf(run, drifting, ready),
            (event) =>
              !(disposed.has(run.id) && pipe_(event.key, Str.startsWith(`${run.id}:ended:`))),
          ),
        ],
        (event) => event.key,
      ),
    ),
  );
}

function reopenedOf(run: RunFacts, done: ReadonlyMap<string, Reopened>) {
  const finished = done.get(run.id);
  if (finished === undefined) {
    const returned: Event[] = [];
    return returned;
  }
  const told = finished.told === null ? "" : ` (“${finished.told}”)`;
  const returned: Event[] = [
    {
      run: run.id,
      key: `${run.id}:reopened:${finished.delivery}`,
      significance: "consequential",
      text: `Run ${run.id} (${runTitle(run)}): ${finished.agent} has finished what it was told after the Run ended${told}. What came of it?`,
    },
  ];
  return returned;
}

export const disputesIn = Effect.fn("Proactive.disputesIn")(function* (
  runs: ReadonlyArray<Pick<RunFacts, "id" | "dir">>,
) {
  const out: Event[] = [];
  for (const run of runs)
    for (const reply of yield* readReplies(run.dir).pipe(Effect.orElseSucceed(() => [])))
      if (reply.kind === "disputed")
        out.push({
          run: run.id,
          key: `${run.id}:disputed:${reply.comment}`,
          significance: "consequential",
          text: `Run ${run.id} replied for you on ${mrLabel(reply.mr)}, disputing ${reply.comment}:\n${reply.body}\nShould it stand?`,
        });
  return out;
});

function causesOf(
  run: RunFacts,
  drifting: ReadonlyMap<string, string>,
  ready: ReadonlyMap<string, { at: string; sentence: string }>,
) {
  const about = runTitle(run);
  const out: Event[] = Arr.map(run.asking, (asked) => ({
    run: run.id,
    key: `${run.id}:asking:${asked.name}`,
    significance: "decision",
    text: `Run ${run.id} (${about}) is waiting on me (${asked.name}). What is it asking, and what turns on the answer?`,
  }));
  const drifted = drifting.get(run.id);
  if (drifted !== undefined && !settled(run))
    out.push({
      run: run.id,
      key: `${run.id}:drift:${drifted}`,
      significance: "decision",
      text: `Run ${run.id} (${about}) drifted from ${drifted} and Collie could not correct it. What is it doing instead, and should it be stopped or steered?`,
    });
  if (run.state === "waiting" && run.asking.length === 0 && run.park?.kind !== "rechecks")
    out.push({
      run: run.id,
      key: `${run.id}:parked:${run.note ?? ""}`,
      significance: "consequential",
      text: `Run ${run.id} (${about}) parked its work${run.note === null ? "" : `: ${run.note}`}. What does it need, and from whom?`,
    });
  const shippable = ready.get(run.id);
  if (shippable !== undefined)
    out.push({
      run: run.id,
      key: `${run.id}:ready:${shippable.at}`,
      significance: "try-it",
      text: `Run ${run.id} (${about}): ${shippable.sentence}`,
    });
  if (settled(run))
    out.push({
      run: run.id,
      key: `${run.id}:ended:${run.state}`,
      significance: "consequential",
      text: `Run ${run.id} (${about}) ended ${run.state}. What came of it, and is there anything left to do?`,
    });
  return out;
}

export function idleAgain(views: ReadonlyArray<TaskView>, seen: Set<string>) {
  const idle = new Map<string, Reopened>();
  for (const view of views) {
    const reopened = view.reopened ?? null;
    if (reopened === null) continue;
    if (reopened.status === "working") seen.add(reopened.delivery);
    else if (reopened.status !== "blocked" && seen.delete(reopened.delivery))
      idle.set(view.run, reopened);
  }
  return idle;
}

export const saidPath = Effect.fn("Proactive.saidPath")(function* (herdDir: string) {
  const path = yield* Path.Path;
  return path.join(herdDir, "proactive.jsonl");
});

export const readSaid = Effect.fn("Proactive.readSaid")(function* (herdDir: string) {
  const lines = yield* readJournal(yield* saidPath(herdDir), SaidJson).pipe(
    Effect.orElseSucceed(() => []),
  );
  return new Set(Arr.map(lines, (line) => line.key));
});

export const remember = Effect.fn("Proactive.remember")(function* (
  herdDir: string,
  key: string,
  at: string,
) {
  yield* appendJournal(yield* saidPath(herdDir), SaidJson, { at, key }).pipe(Effect.orDie);
});
