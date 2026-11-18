import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { AgentEntry } from "./registry";
import type { RunFacts } from "./runs";
import { newest, readCards, type Card } from "./cards";
import type { Marks, RunMarks } from "./lines";
import { openReports, readDrift } from "./drift";
import { capabilitiesOf } from "./steering-caps";
import { DriftReportSchema, type DriftReport } from "./evaluator";
import { readIntent } from "./intent";
import { appendJournal, readJournal } from "./journal";
import {
  newsPath,
  pending as pendingNews,
  read as readNews,
  uncertain as uncertainNews,
} from "./news";
import { pendingFor, pendingHerdWide, type ProposalLine, type ProposalRecord } from "./proposals";
import { herdDir, type Delivery } from "./steering";

const CARDS = 5;
export interface Live {
  run: string | null;
  cards: Card[];
  drift: DriftReport[];
  deliveries: Delivery[];
  proposals: ProposalRecord[];
  pending: DriftReport[];
  news: { readonly waiting: number; readonly uncertain: number };
}

export interface LiveRun {
  id: string;
  dir: string;
}

const DriftJson = Schema.fromJsonString(DriftReportSchema);

export const pendingReportsPath = Effect.fn("Live.pendingReportsPath")(function* (
  stateDir: string,
  herdKey: string,
  run: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, herdKey), "pending-reports", `${run}.jsonl`);
});

export const appendPendingReport = Effect.fn("Live.appendPendingReport")(function* (
  stateDir: string,
  herdKey: string,
  run: string,
  report: DriftReport,
) {
  yield* appendJournal(yield* pendingReportsPath(stateDir, herdKey, run), DriftJson, report);
});

export const readPendingReports = Effect.fn("Live.readPendingReports")(function* (
  stateDir: string,
  herdKey: string,
  run: string,
) {
  return yield* readJournal(yield* pendingReportsPath(stateDir, herdKey, run), DriftJson);
});

export interface MarkedRun extends LiveRun {
  held: boolean;
  harnesses: ReadonlyArray<string>;
}

export function markedOf(
  run: Pick<RunFacts, "id" | "dir" | "held">,
  registered: ReadonlyArray<AgentEntry>,
) {
  const harnesses = Arr.flatMap(registered, (entry) =>
    entry.runId === run.id && entry.incarnation?.agentSession
      ? [entry.incarnation.agentSession.kind]
      : [],
  );
  return { id: run.id, dir: run.dir, held: run.held, harnesses: [...new Set(harnesses)] };
}

export interface BoardLive {
  readonly live: Live | null;
  readonly marks: Marks;
}

export interface Ledgers {
  readonly overridden: Effect.Effect<ReadonlySet<string>, never, Client>;
  readonly deliveriesOf: (run: string) => Effect.Effect<ReadonlyArray<Delivery>, never, Client>;
  readonly proposals: (herd: string) => Effect.Effect<ReadonlyArray<ProposalLine>, never, Client>;
}

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export const liveFor = Effect.fn("Live.for")(function* (opts: {
  stateDir: string;
  herd: string | null;
  ledgers: Ledgers;
  run: LiveRun | null;
  runs: ReadonlyArray<MarkedRun>;
  region: boolean;
}) {
  const now = yield* Clock.currentTimeMillis;
  const key = opts.herd;
  const lines = key === null ? [] : yield* opts.ledgers.proposals(key);
  const overridden = opts.runs.length === 0 ? new Set<string>() : yield* opts.ledgers.overridden;

  const cardsOf = new Map<string, Card[]>();
  const marks: Record<string, RunMarks> = {};
  for (const run of opts.runs) {
    const cards = yield* readCards(run.dir);
    cardsOf.set(run.id, cards);
    const mark: RunMarks = {
      tryIt: newest(cards).at(-1)?.significance === "try-it",
      drift: openReports(yield* readDrift(run.dir)).length > 0,
      held: run.held,
      override: overridden.has(run.id),
      unattributed: yield* unattributed(run),
      proposal: pendingFor(lines, run.id, now).length > 0,
    };
    if (Arr.some(Rec.values(mark), (set) => set)) marks[run.id] = mark;
  }
  let live: Live | null = null;
  if (opts.region) {
    const newsLines = key === null ? [] : yield* readNews(yield* newsPath(opts.stateDir, key));
    const news = {
      waiting: pendingNews(newsLines).items.length,
      uncertain: uncertainNews(newsLines).length,
    };
    const herdWide = pendingHerdWide(lines, now);
    const one = opts.run;
    if (one === null) {
      const cards: Card[] = [];
      for (const run of opts.runs) cards.push(...(cardsOf.get(run.id) ?? []));
      live = {
        news,
        run: null,
        cards: newest(cards).slice(-CARDS).reverse(),
        drift: [],
        deliveries: [],
        proposals: herdWide,
        pending: [],
      };
    } else {
      const own = cardsOf.get(one.id) ?? (yield* readCards(one.dir));
      live = {
        news,
        run: one.id,
        cards: newest(own).slice(-CARDS).reverse(),
        drift: openReports(yield* readDrift(one.dir)),
        deliveries: [...(yield* opts.ledgers.deliveriesOf(one.id))],
        proposals: [...pendingFor(lines, one.id, now), ...herdWide],
        pending: key === null ? [] : yield* readPendingReports(opts.stateDir, key, one.id),
      };
    }
  }
  return { live, marks } satisfies BoardLive;
});

const unattributed = Effect.fn("Live.unattributed")(function* (run: MarkedRun) {
  if (run.harnesses.length === 0) return false;
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => null));
  if (intent === null) return false;
  const { auto_correct, exclusive_steering } = intent.authority;
  if (!auto_correct || !exclusive_steering) return false;
  return Arr.some(
    run.harnesses,
    (harness) => capabilitiesOf(harness)?.attribution?.status !== "proven",
  );
});
